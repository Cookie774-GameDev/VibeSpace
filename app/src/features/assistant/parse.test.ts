import { parseAssistantInput } from './parse';

describe('parseAssistantInput terminal commands', () => {
  it('opens a known CLI directly in a terminal pane', () => {
    expect(parseAssistantInput('open opencode')).toMatchObject({
      kind: 'open_terminals',
      count: 1,
      command: 'opencode',
    });
  });

  it('opens a blank terminal from the natural singular form', () => {
    expect(parseAssistantInput('open a terminal')).toMatchObject({
      kind: 'open_terminals',
      count: 1,
    });
  });

  it('turns "open terminal and type" into one startup-command pane', () => {
    expect(parseAssistantInput('open a terminal and type opencode')).toMatchObject({
      kind: 'open_terminals',
      count: 1,
      command: 'opencode',
    });
  });

  it('turns "open terminal then run" into one startup-command pane', () => {
    expect(parseAssistantInput('open terminal then run npm test')).toMatchObject({
      kind: 'open_terminals',
      count: 1,
      command: 'npm test',
    });
  });

  it('preserves true multi-step project workflows', () => {
    expect(parseAssistantInput('create project tiger then open 4 terminals with opencode')).toMatchObject({
      kind: 'multi_step',
      steps: [
        { kind: 'create_project', name: 'tiger' },
        { kind: 'open_terminals', count: 4, command: 'opencode' },
      ],
    });
  });
});

describe('parseAssistantInput removed clock commands', () => {
  it('does not parse one-hour timer requests', () => {
    expect(parseAssistantInput('make me a one-hour timer')).toMatchObject({
      kind: 'unknown',
    });
  });

  it('does not parse timer seconds and labels', () => {
    expect(parseAssistantInput('set timer for 1 minute 30 seconds called tea')).toMatchObject({
      kind: 'unknown',
    });
  });

  it('does not parse alarm requests', () => {
    expect(parseAssistantInput('set an alarm for 3:30 PM')).toMatchObject({
      kind: 'unknown',
    });
  });
});
