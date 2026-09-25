import { describe, expect, it } from 'vitest';
import { latestOpenCodeReply, latestOpenCodeScreenReply } from './peerRelayOutput';

describe('latestOpenCodeReply', () => {
  it('extracts a completed GPT-6 Luna answer from redraw noise', () => {
    const transcript = '⬝■'.repeat(100) +
      '  ▣ Build · GPT-6 LunaPEER-A-READY-X26 · 7m 1s14.5K (1%)' +
      '┃Build · GPT-6 Luna OpenAI╹▀▀';
    expect(latestOpenCodeReply(transcript)).toBe('PEER-A-READY-X26');
  });

  it('does not relay a prompt, spinner, or unfinished answer', () => {
    expect(latestOpenCodeReply('[CAO acting for user] Hello ⬝■■ Build · GPT-6 Luna OpenAI')).toBeNull();
  });

  it('discards repeated redraw markers before the completed reply', () => {
    const transcript = '▣ Build · GPT-6 Luna ▣ Build · GPT-6 LunaThe message was corrupted. · 2m 5s' +
      '┃Build·GPT-6 LunaOpenAI╹▀';
    expect(latestOpenCodeReply(transcript)).toBe('The message was corrupted.');
  });

  it('reads the last completed reply from the native screen snapshot', () => {
    const screen = [
      '  ┃  [CAO acting for user]',
      '  ┃  Message from Peer A:',
      '  ┃  PEER-A-READY-X26',
      '  ┃  Please reply to this peer message.',
      '',
      '     PEER-A-ACK-X26 — received.',
      '',
      '     ▣ Build · GPT-6 Luna · 5m 53s',
      '  ┃  Build · GPT-6 Luna OpenAI',
    ].join('\n');
    expect(latestOpenCodeScreenReply(screen)).toBe('PEER-A-ACK-X26 — received.');
  });

  it('does not read an answer before the latest prompt has completed', () => {
    const screen = '▣ Build · GPT-6 Luna · 1m\n┃ [CAO acting for user]\n┃ New prompt\npartial';
    expect(latestOpenCodeScreenReply(screen)).toBeNull();
  });
});
