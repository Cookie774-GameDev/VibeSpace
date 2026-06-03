/**
 * @file Tests for the AI-to-app action proposal parser.
 *
 * The parser is responsible for splitting an assistant's final reply
 * text into a mix of prose segments and action-proposal segments. The
 * runtime then fans those segments out to chat `Part`s.
 *
 * These tests pin the contract documented in `parse.ts`:
 *  - well-formed action blocks become `kind: 'action', ok: true` segments
 *  - malformed/empty/unterminated blocks become `kind: 'action', ok: false`
 *    segments with the raw text preserved
 *  - prose around fences is preserved verbatim
 *  - `hasActionBlocks` is set when at least one action segment exists
 */
import { describe, it, expect } from 'vitest';
import { parseActionBlocks } from '@/lib/actions/parse';

describe('parseActionBlocks', () => {
  it('returns a single prose segment when no action fence is present', () => {
    const text = 'hello world\nthis is just chat text';
    const result = parseActionBlocks(text);
    expect(result.hasActionBlocks).toBe(false);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      kind: 'prose',
      text,
    });
  });

  it('parses a well-formed action block with no surrounding prose', () => {
    const text = [
      '```action',
      '{ "id": "nav.chat", "rationale": "user asked to open chat" }',
      '```',
    ].join('\n');
    const result = parseActionBlocks(text);
    expect(result.hasActionBlocks).toBe(true);
    expect(result.segments).toHaveLength(1);
    const seg = result.segments[0]!;
    expect(seg.kind).toBe('action');
    if (seg.kind === 'action' && seg.ok) {
      expect(seg.proposal.action_id).toBe('nav.chat');
      expect(seg.proposal.rationale).toBe('user asked to open chat');
      expect(seg.proposal.params).toEqual({});
      expect(seg.proposal.call_id).toMatch(/^apr_/);
    } else {
      throw new Error('expected ok action segment');
    }
  });

  it('preserves prose before and after a fence', () => {
    const text = [
      'Sure thing — opening the chat now.',
      '',
      '```action',
      '{ "id": "nav.chat" }',
      '```',
      '',
      'Let me know if you need anything else.',
    ].join('\n');
    const result = parseActionBlocks(text);
    expect(result.segments.map((s) => s.kind)).toEqual([
      'prose',
      'action',
      'prose',
    ]);
    expect((result.segments[0] as { text: string }).text).toContain('opening the chat');
    expect((result.segments[2] as { text: string }).text).toContain('Let me know');
  });

  it('rejects missing id with a structured error and preserves the raw block', () => {
    const text = [
      '```action',
      '{ "params": { "x": 1 } }',
      '```',
    ].join('\n');
    const result = parseActionBlocks(text);
    expect(result.hasActionBlocks).toBe(true);
    const seg = result.segments[0]!;
    expect(seg.kind).toBe('action');
    if (seg.kind === 'action' && !seg.ok) {
      expect(seg.error).toMatch(/id/i);
      expect(seg.raw).toContain('```action');
    } else {
      throw new Error('expected error action segment');
    }
  });

  it('rejects ids that are not "<category>.<name>" shaped', () => {
    const text = [
      '```action',
      '{ "id": "nav chat" }',
      '```',
    ].join('\n');
    const result = parseActionBlocks(text);
    const seg = result.segments[0]!;
    if (seg.kind === 'action' && !seg.ok) {
      expect(seg.error).toMatch(/category/);
    } else {
      throw new Error('expected error action segment');
    }
  });

  it('rejects invalid JSON without dropping surrounding text', () => {
    const text = [
      'Going to do this:',
      '',
      '```action',
      '{ "id": "nav.chat", }',
      '```',
      '',
      'Done!',
    ].join('\n');
    const result = parseActionBlocks(text);
    const kinds = result.segments.map((s) => s.kind);
    expect(kinds).toEqual(['prose', 'action', 'prose']);
    const action = result.segments[1]!;
    expect(action.kind).toBe('action');
    if (action.kind === 'action' && !action.ok) {
      expect(action.error).toMatch(/parse|JSON/i);
    }
  });

  it('flags an unterminated fence rather than swallowing the body', () => {
    const text = [
      'Starting…',
      '```action',
      '{ "id": "nav.chat" }',
      // no closing fence
    ].join('\n');
    const result = parseActionBlocks(text);
    const action = result.segments.find((s) => s.kind === 'action');
    expect(action).toBeTruthy();
    if (action && action.kind === 'action' && !action.ok) {
      expect(action.error).toMatch(/never closed|closed/i);
    }
  });

  it('handles multiple action blocks in a single reply', () => {
    const text = [
      'Step 1:',
      '```action',
      '{ "id": "nav.chat" }',
      '```',
      'Step 2:',
      '```action',
      '{ "id": "wellness.eyeBreak", "params": { "durationSec": 30 } }',
      '```',
    ].join('\n');
    const result = parseActionBlocks(text);
    const actionSegs = result.segments.filter((s) => s.kind === 'action');
    expect(actionSegs).toHaveLength(2);
    if (actionSegs[1]!.kind === 'action' && actionSegs[1]!.ok) {
      expect(actionSegs[1]!.proposal.action_id).toBe('wellness.eyeBreak');
      expect(actionSegs[1]!.proposal.params).toEqual({ durationSec: 30 });
    }
  });

  it('rejects array-shaped params (must be object)', () => {
    const text = [
      '```action',
      '{ "id": "nav.chat", "params": [1, 2, 3] }',
      '```',
    ].join('\n');
    const result = parseActionBlocks(text);
    const seg = result.segments[0]!;
    if (seg.kind === 'action' && !seg.ok) {
      expect(seg.error).toMatch(/params/);
    } else {
      throw new Error('expected error');
    }
  });

  it('treats an empty fence body as a structured error', () => {
    const text = ['```action', '```'].join('\n');
    const result = parseActionBlocks(text);
    const seg = result.segments[0]!;
    if (seg.kind === 'action' && !seg.ok) {
      expect(seg.error).toMatch(/empty/i);
    } else {
      throw new Error('expected empty-body error');
    }
  });
});
