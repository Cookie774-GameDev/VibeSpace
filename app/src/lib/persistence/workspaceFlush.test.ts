import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushWorkspacePersistence } from './workspaceFlush';
import { captureLiveTree, _resetLiveCacheForTests } from '@/features/terminals/terminalLiveCache';
import { terminalTreeStorageKey } from '@/features/terminals/terminalProjectMove';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import type { PaneNode } from '@/features/terminals/paneTree';

function leaf(id: string, sessionId: string): PaneNode {
  return {
    kind: 'leaf',
    id,
    sessionId,
    projectId: 'project-a',
    command: 'powershell.exe',
    currentInput: undefined,
  } as PaneNode;
}

describe('flushWorkspacePersistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetLiveCacheForTests();
    useTerminalTranscriptStore.getState().reset();
  });

  it('broadcasts terminal persist before flushing transcripts and pane trees', () => {
    const order: string[] = [];
    window.addEventListener(
      'jarvis:terminal:persist-now',
      () => {
        order.push('event');
        useTerminalTranscriptStore
          .getState()
          .registerSession('pty-live', {
            paneId: 'pane-a',
            projectId: 'project-a',
            command: 'powershell.exe',
          });
        useTerminalTranscriptStore.getState().appendOutput('pty-live', 'last second output\n');
      },
      { once: true },
    );
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
      key,
      value,
    ) {
      if (key === 'jarvis-terminal-transcripts') order.push('storage');
      return originalSetItem.call(this, key, value);
    });

    captureLiveTree('project-a', leaf('pane-a', 'pty-live'));
    flushWorkspacePersistence('test');

    expect(order.indexOf('event')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('storage')).toBeGreaterThan(order.indexOf('event'));
    expect(window.localStorage.getItem(terminalTreeStorageKey('project-a'))).toContain('pane-a');
    expect(window.localStorage.getItem('jarvis-terminal-transcripts')).toContain('last second output');
  });
});
