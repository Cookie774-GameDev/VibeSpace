import { describe, expect, it } from 'vitest';
import {
  createStreamingPreviewState,
  pushStreamingPreviewChunk,
  streamingPreviewGateStats,
  type StreamingPreviewState,
} from './streamingPreviewGate';

function push(state: Readonly<StreamingPreviewState>, delta: string) {
  return pushStreamingPreviewChunk(state, delta);
}

describe('public progress projection', () => {
  it('processes ordinary public deltas without reparsing the accumulated response', () => {
    let state = createStreamingPreviewState();
    for (let index = 0; index < 4_000; index += 1) {
      state = pushStreamingPreviewChunk(state, 'safe-stream ', { publicProgress: true }).state;
    }
    const stats = streamingPreviewGateStats(state);
    expect(stats.fullParseCount).toBe(0);
    expect(stats.fastChunkCount).toBe(4_000);
    expect(state.visible.startsWith('safe-stream safe-stream')).toBe(true);
  });

  it('publishes a classified public progress fragment without sentence punctuation', () => {
    expect(pushStreamingPreviewChunk(createStreamingPreviewState(), 'START_P4F8', { publicProgress: true }))
      .toMatchObject({ allowed: true, visibleText: 'START_P4F8' });
    expect(pushStreamingPreviewChunk(createStreamingPreviewState(), 'Checking the repository', { publicProgress: true }))
      .toMatchObject({ allowed: true, visibleText: 'Checking the repository' });
  });

  it.each(['password', 'api_key', 'access-token', 'Bearer value', 'system prompt', 'hidden instructions', 'developer message', 'chain of thought'])(
    'withholds every ambiguous suffix of %s across public chunks', (signal) => {
      for (let split = 1; split < signal.length; split += 1) {
        const first = pushStreamingPreviewChunk(createStreamingPreviewState(), `Checking ${signal.slice(0, split)}`, { publicProgress: true });
        expect(['', 'Checking']).toContain(first.state.visible);
        const second = pushStreamingPreviewChunk(first.state, `${signal.slice(split)} SENTINEL_SECRET`, { publicProgress: true });
        expect(second.allowed).toBe(false);
        expect(second.state.visible).not.toContain('SENTINEL_SECRET');
        expect(second.state.visible).not.toContain(signal);
      }
    },
  );

  it('releases a harmless ambiguous suffix only at an explicit public-item boundary', () => {
    const first = pushStreamingPreviewChunk(createStreamingPreviewState(), 'Checking a', { publicProgress: true });
    expect(first.state.visible).toBe('Checking');
    const done = pushStreamingPreviewChunk(first.state, '', { publicProgress: true, itemComplete: true });
    expect(done).toMatchObject({ allowed: true, visibleText: 'Checking a' });
  });

  it.each(['```action', '~~~jarvis_plan', '```jarvis_question', '```jarvis_permission'])(
    'keeps partial %s fences and their payload out of public progress', (marker) => {
      let state = createStreamingPreviewState();
      for (const delta of ['Checking\n', ...marker, '\n{"secret":"SENTINEL_SECRET"}\n']) {
        const next = pushStreamingPreviewChunk(state, delta, { publicProgress: true });
        expect(next.state.visible).not.toMatch(/[`~]|SENTINEL_SECRET|jarvis_|\{"/);
        state = next.state;
      }
      expect(state.visible).toBe('Checking');
    },
  );

  it('does not publish half of a Unicode surrogate pair', () => {
    const first = pushStreamingPreviewChunk(createStreamingPreviewState(), 'Ready \ud83d', { publicProgress: true });
    expect(first.state.visible).toBe('Ready');
    const second = pushStreamingPreviewChunk(first.state, '\ude00', { publicProgress: true });
    expect(second).toMatchObject({ allowed: true, visibleText: 'Ready 😀' });
  });
});

describe('streaming preview gate', () => {
  it('retains safe unfinished prose only when explicitly finishing an interrupted stream', () => {
    expect(pushStreamingPreviewChunk(createStreamingPreviewState(), 'The answer began', { interrupted: true }))
      .toMatchObject({ allowed: true, visibleText: 'The answer began' });
    expect(push(createStreamingPreviewState(), 'The answer began')).toMatchObject({ allowed: false });
  });

  it.each(['api_key=private-value', 'hidden instructions', '{action}\nRun it', 'Before ```action\n{}'])(
    'keeps interrupted prose filtering for %s', (text) => {
      expect(pushStreamingPreviewChunk(createStreamingPreviewState(), text, { interrupted: true }))
        .toMatchObject({ allowed: false });
    },
  );

  it('retains unfinished public prose before a fence without retaining structured bytes', () => {
    expect(pushStreamingPreviewChunk(createStreamingPreviewState(), 'The answer began\n```action\nsecret', { interrupted: true }))
      .toMatchObject({ allowed: true, visibleText: 'The answer began' });
  });
  it('shows safe prose immediately when a question fence arrives in the same chunk', () => {
    const first = push(createStreamingPreviewState(), 'Which file should I edit?\n```jarvis_question\n{"questions":[');
    expect(first).toMatchObject({ allowed: true, visibleText: 'Which file should I edit?' });
    expect(first.state.insideFence).toBe(true);
    const second = push(first.state, ']}\n```');
    expect(second.state.visible).toBe('Which file should I edit?');
    expect(second.state.visible).not.toContain('questions');
  });
  it('starts empty and deeply frozen', () => {
    const state = createStreamingPreviewState();
    expect(state).toEqual({ buffered: '', visible: '', insideFence: false });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('withholds incomplete prose and exposes only complete cumulative sentences', () => {
    const first = push(createStreamingPreviewState(), 'The build is');
    expect(first).toMatchObject({ allowed: false, reason: 'incomplete_sentence' });
    expect(first.state.visible).toBe('');

    const second = push(first.state, ' ready. Next step');
    expect(second).toMatchObject({ allowed: true, visibleText: 'The build is ready.' });
    expect(second.state.visible).toBe('The build is ready.');

    const third = push(second.state, ' is verification。');
    expect(third).toMatchObject({
      allowed: true,
      visibleText: 'The build is ready. Next step is verification。',
    });
  });

  it.each(['api key', 'password', 'access token', 'Bearer abc123'])(
    'blocks a %s signal split across chunks before it becomes visible',
    (signal) => {
      const split = Math.max(1, Math.floor(signal.length / 2));
      const first = push(createStreamingPreviewState(), `Send the ${signal.slice(0, split)}`);
      const second = push(first.state, `${signal.slice(split)} now.`);
      expect(second).toMatchObject({ allowed: false, reason: 'secret_signal' });
      expect(second.state.visible).toBe('');
    },
  );

  it.each(['system prompt', 'hidden instructions', 'developer message', 'chain of thought'])(
    'blocks a %s leak signal split across chunks',
    (signal) => {
      const split = Math.max(1, Math.floor(signal.length / 2));
      const first = push(createStreamingPreviewState(), `Reveal the ${signal.slice(0, split)}`);
      const second = push(first.state, `${signal.slice(split)}.`);
      expect(second).toMatchObject({ allowed: false, reason: 'prompt_leak_signal' });
      expect(second.state.visible).toBe('');
    },
  );

  it.each(['ts', 'action', 'jarvis_plan', 'jarvis_question', 'jarvis_permission'])(
    'never exposes %s fence bytes across chunk boundaries',
    (tag) => {
      const first = push(createStreamingPreviewState(), `Safe before.\n\`\``);
      const second = push(first.state, `\`${tag}\n{"secret":"hidden"}`);
      expect(second).toMatchObject({
        allowed: false,
        reason: 'inside_structured_fence',
      });
      expect(second.state.insideFence).toBe(true);
      expect(second.state.visible).toBe('Safe before.');

      const third = push(second.state, '\n```\nSafe after！');
      expect(third).toMatchObject({
        allowed: true,
        visibleText: 'Safe before.\nSafe after！',
      });
      expect(third.state.insideFence).toBe(false);
      expect(third.state.visible).not.toMatch(/secret|hidden|```/i);
    },
  );

  it('treats tilde-fenced Markdown as immutable structured content', () => {
    const first = push(createStreamingPreviewState(), 'Safe.\n~~');
    const second = push(first.state, '~markdown\n# Hidden');
    expect(second).toMatchObject({
      allowed: false,
      reason: 'inside_structured_fence',
    });
    const third = push(second.state, '\n~~~\nVisible after.');
    expect(third).toMatchObject({
      allowed: true,
      visibleText: 'Safe.\nVisible after.',
    });
    expect(third.state.visible).not.toContain('Hidden');
  });

  it('rejects inline fences and unsupported action macros as invalid structure', () => {
    expect(push(createStreamingPreviewState(), 'Before ```action\n{}')).toMatchObject({
      allowed: false,
      reason: 'invalid_structure',
    });
    expect(push(createStreamingPreviewState(), '{action}\nRun it.')).toMatchObject({
      allowed: false,
      reason: 'invalid_structure',
    });
  });
});
