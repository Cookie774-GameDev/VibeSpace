import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readTextFileSample: vi.fn(),
  listDirectory: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@/lib/fs', () => ({
  readTextFileSample: fsMocks.readTextFileSample,
  listDirectory: fsMocks.listDirectory,
  writeTextFile: fsMocks.writeTextFile,
}));

vi.mock('@/lib/db', () => ({
  projectRepo: { getById: vi.fn() },
}));

import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { getExplicitFilesBlock, getExplicitTerminalBlock } from './context';

describe('AI explicit file context safeguards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalTranscriptStore.getState().reset();
  });

  it('samples attached text files instead of reading them in full', async () => {
    fsMocks.readTextFileSample.mockResolvedValue({
      ok: true,
      path: 'C:\\repo\\large.log',
      content: 'a'.repeat(20_000),
    });

    const block = await getExplicitFilesBlock(['C:\\repo\\large.log']);

    expect(fsMocks.readTextFileSample).toHaveBeenCalledWith('C:\\repo\\large.log', 64 * 1024);
    expect(block).toContain('C:\\repo\\large.log (truncated)');
    expect(block.length).toBeLessThan(18_000);
  });

  it('adds media attachments as metadata without reading binary bytes', async () => {
    const block = await getExplicitFilesBlock([
      'C:\\repo\\assets\\hero.png',
      'C:\\repo\\clips\\demo.mp4',
    ]);

    expect(fsMocks.readTextFileSample).not.toHaveBeenCalled();
    expect(block).toContain('Media file metadata only (image).');
    expect(block).toContain('Media file metadata only (video).');
    expect(block).toContain('Binary bytes were not read into the prompt.');
  });

  it('frames attached terminal transcripts as evidence instead of completion guesses', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_done', {
      paneId: 'pane_terminal',
      projectId: 'project_a',
      agentSlug: 'coder',
      command: 'opencode',
    });
    store.appendOutput('pty_done', 'Running tests...\nAll tests passed\n');
    store.setCurrentInput('pty_done', 'npm run build');

    const block = getExplicitTerminalBlock([{
      sessionId: 'pty_done',
      paneId: 'pane_terminal',
      label: 'opencode',
      agentSlug: 'coder',
    }]);

    expect(block).toContain('Treat the transcript as evidence, not proof of completion.');
    expect(block).toContain('only say yes when the visible output clearly shows completion');
    expect(block).toContain('current_input="npm run build"');
    expect(block).toContain('All tests passed');
  });
});
