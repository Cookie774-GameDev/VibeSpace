import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSpeechHistorySession,
  readSpeechHistory,
  deleteSpeechHistoryEntry,
} from './speechHistory';

describe('speech recovery history', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  it('persists every partial immediately and keeps one entry through corrections and interruption', () => {
    const session = createSpeechHistorySession('system');
    session.partial('hello wor');
    expect(readSpeechHistory()[0].text).toBe('hello wor');
    session.partial('hello world');
    session.final('hello world');
    session.partial('next thought');
    session.finish('interrupted');
    expect(readSpeechHistory()).toHaveLength(1);
    expect(readSpeechHistory()[0]).toMatchObject({
      text: 'hello world next thought',
      status: 'interrupted',
    });
    expect(
      JSON.parse(localStorage.getItem(`vibespace:speech-history:v1:${readSpeechHistory()[0].id}`)!),
    ).toMatchObject({ text: 'hello world next thought' });
  });
  it('keeps repeated Deepgram segments and replaces cumulative system finals without duplication', () => {
    const cloud = createSpeechHistorySession('deepgram');
    cloud.final('yes');
    cloud.final('yes');
    cloud.finish('completed');
    const system = createSpeechHistorySession('system');
    system.final('one');
    system.final('one two');
    system.finish('completed');
    expect(readSpeechHistory().map((row) => row.text)).toEqual(
      expect.arrayContaining(['yes yes', 'one two']),
    );
  });
  it('retains the newest 50 sessions, ignores empty sessions and survives a new module instance', async () => {
    createSpeechHistorySession('system').finish('interrupted');
    for (let i = 0; i < 53; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(1000 + i);
      createSpeechHistorySession('system').partial(`talk ${i}`);
    }
    vi.resetModules();
    const fresh = await import('./speechHistory');
    const rows = fresh.readSpeechHistory();
    expect(rows).toHaveLength(50);
    expect(rows[0].text).toBe('talk 52');
    expect(rows.at(-1)?.text).toBe('talk 3');
  });
  it('does not resurrect an entry deleted while its speaker is still active', () => {
    const session = createSpeechHistorySession('system');
    session.partial('private');
    deleteSpeechHistoryEntry(readSpeechHistory()[0].id);
    session.final('private words');
    session.finish('completed');
    expect(readSpeechHistory()).toEqual([]);
  });
  it('does not overwrite another window entry and ignores malformed storage', () => {
    const first = createSpeechHistorySession('system');
    const other = createSpeechHistorySession('system');
    first.partial('first');
    other.partial('other');
    first.partial('first corrected');
    localStorage.setItem('vibespace:speech-history:v1:broken', '{');
    expect(readSpeechHistory().map((row) => row.text)).toEqual(
      expect.arrayContaining(['first corrected', 'other']),
    );
  });
  it('does not break speech when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() =>
      createSpeechHistorySession('system').partial('recoverable in memory'),
    ).not.toThrow();
  });
});
