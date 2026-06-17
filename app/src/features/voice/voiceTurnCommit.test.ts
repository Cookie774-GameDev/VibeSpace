import { describe, expect, it } from 'vitest';
import {
  VOICE_COMMIT_PHRASE_DEFAULT,
  clampVoiceCommitPhrase,
  detectCancelPhrase,
  detectCommitPhrase,
  normalizeVoicePhrase,
  processVoiceFinalEvent,
  shouldAutoSendOnSilence,
  stripCommitPhrase,
} from './voiceTurnCommit';

describe('voiceTurnCommit', () => {
  it('normalizes phrases for case-insensitive matching', () => {
    expect(normalizeVoicePhrase('Send  IT!!!')).toBe('send it');
  });

  it('detects commit phrase at end of transcript', () => {
    const result = detectCommitPhrase('Help me plan a landing page send it', 'send it');
    expect(result.committed).toBe(true);
    expect(result.messageText).toBe('help me plan a landing page');
  });

  it('detects commit phrase when transcript is only the phrase', () => {
    const result = detectCommitPhrase('send it', 'send it');
    expect(result.committed).toBe(true);
    expect(result.messageText).toBe('');
  });

  it('does not commit without the phrase', () => {
    const result = detectCommitPhrase('So the idea is', 'send it');
    expect(result.committed).toBe(false);
  });

  it('strips commit phrase case-insensitively', () => {
    expect(stripCommitPhrase('Make it shorter SEND IT', 'send it')).toBe('make it shorter');
  });

  it('detects cancel phrase', () => {
    expect(detectCancelPhrase('never mind cancel', 'cancel')).toBe(true);
    expect(detectCancelPhrase('keep going', 'cancel')).toBe(false);
  });

  it('clamps commit phrase length', () => {
    expect(clampVoiceCommitPhrase('a')).toBe(VOICE_COMMIT_PHRASE_DEFAULT);
    expect(clampVoiceCommitPhrase('  go ahead  ')).toBe('go ahead');
  });

  it('uses silence auto-send only for click-to-talk or hands-free silence mode', () => {
    expect(shouldAutoSendOnSilence(false, 'phrase')).toBe(true);
    expect(shouldAutoSendOnSilence(true, 'phrase')).toBe(false);
    expect(shouldAutoSendOnSilence(true, 'silence')).toBe(true);
  });

  it('ignores finals while Jarvis is busy', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'more talking',
        currentDraft: 'hello',
        turnBusy: true,
        handsFree: true,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'ignore' });
  });

  it('accumulates without commit phrase in hands-free phrase mode', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'another thought',
        currentDraft: 'so the idea is',
        turnBusy: false,
        handsFree: true,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'accumulate', draft: 'so the idea is another thought' });
  });

  it('commits when phrase is spoken', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'send it',
        currentDraft: 'help me plan',
        turnBusy: false,
        handsFree: true,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'commit', draft: '', messageText: 'help me plan' });
  });

  it('cancels draft on cancel phrase', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'cancel',
        currentDraft: 'actually never mind',
        turnBusy: false,
        handsFree: true,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'cancel', draft: '' });
  });

  it('schedules silence flush for click-to-talk', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'hello there',
        currentDraft: '',
        turnBusy: false,
        handsFree: false,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'schedule_flush', draft: 'hello there' });
  });
});
