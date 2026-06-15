import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalTranscriptStore } from './transcriptStore';
import {
  hasFreshTerminalActivity,
  startTerminalSwarmBridge,
  useTerminalSwarmStore,
} from './terminalSwarmBridge';

describe('terminalSwarmBridge', () => {
  beforeEach(() => {
    useTerminalTranscriptStore.setState({ sessions: {} });
    useTerminalSwarmStore.setState({ byAgent: {} });
  });

  it('publishes activity when transcript updates', () => {
    const stop = startTerminalSwarmBridge();
    useTerminalTranscriptStore.getState().registerSession('pty_1', {
      agentSlug: 'coder',
      command: 'claude',
    });
    useTerminalTranscriptStore.getState().appendOutput('pty_1', 'hello world\n');
    expect(hasFreshTerminalActivity('coder')).toBe(true);
    stop();
  });

  it('returns false for unknown agent', () => {
    expect(hasFreshTerminalActivity('missing')).toBe(false);
  });
});
