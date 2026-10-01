import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { avatarProfileForId, RelayAvatarStore, RelayDeliveryTracker } from './relayAvatarModel';
import type { RelayRoomMessage, RelayRoomView } from './RelayGroupChat';
const m = (id: string, participantId = 'coral-guide', at = 2000): RelayRoomMessage => ({ id, participantId, at, text: id, kind: 'message' });
const r = (messages: RelayRoomMessage[] = [], overrides: Partial<RelayRoomView> = {}): RelayRoomView => ({
  roomId: 'test-room', connection: 'connected', scope: 'Project',
  participants: [
    { id: 'coral-guide', name: 'Coral Guide', kind: 'agent', status: 'online' },
    { id: 'tide-scout', name: 'Tide Scout', kind: 'agent', status: 'online' },
    { id: 'human', name: 'You', kind: 'human', status: 'online' },
  ], messages, ...overrides,
});

describe('Relay delivery provenance', () => {
  it('preserves the explicit source identities and deterministic ID assignment', () => {
    expect(avatarProfileForId('coral-guide')).toBe('coral-guide');
    expect(avatarProfileForId('tide-scout')).toBe('tide-scout');
    const first = avatarProfileForId('agent-stable');
    for (let i=0; i<20; i++) expect(avatarProfileForId('agent-stable')).toBe(first);
  });
  it('baselines history and emits each author/message pair once, including equal timestamps', () => {
    const tracker = new RelayDeliveryTracker();
    expect(tracker.consume(r([m('history')]))).toEqual([]);
    const next = r([m('history'), m('new'), m('new')]);
    expect(tracker.consume(next).map(x => x.id)).toEqual(['new']);
    expect(tracker.consume({ ...next, messages: [...next.messages].reverse() })).toEqual([]);
    expect(tracker.consume(r([m('new', 'tide-scout')])).map(x => x.participantId)).toEqual(['tide-scout']);
  });
  it('ignores older pages, invalid dates, missing IDs, human and unknown authors', () => {
    const tracker = new RelayDeliveryTracker();
    tracker.consume(r([m('baseline')]));
    expect(tracker.consume(r([m('old','coral-guide',1000), m('bad','coral-guide',NaN), m(''), m('human','human'), m('unknown','missing')]))).toEqual([]);
    expect(tracker.consume(r([m('next','coral-guide',3000)])).map(x=>x.id)).toEqual(['next']);
  });
  it('handles the first live message in an empty room without treating reconnect as live delivery', () => {
    const tracker = new RelayDeliveryTracker();
    tracker.consume(r());
    expect(tracker.consume(r([m('first')]))).toHaveLength(1);
    tracker.consume(r([], { connection: 'offline' }));
    tracker.consume(r([], { connection: 'connecting' }));
    expect(tracker.consume(r([m('first'), m('during-outage','tide-scout',3000)]))).toEqual([]);
    expect(tracker.consume(r([m('live-again','tide-scout',4000)]))).toHaveLength(1);
  });
  it('baselines hidden UI, remounts, scope and explicit room changes', () => {
    const tracker = new RelayDeliveryTracker();
    tracker.consume(r());
    tracker.consume(r(), false);
    expect(tracker.consume(r([m('closed')]))).toEqual([]);
    expect(tracker.consume(r([m('different-room')], { roomId: 'other' }))).toEqual([]);
    expect(new RelayDeliveryTracker().consume(r([m('remount')]))).toEqual([]);
  });
  it('does not clear deduplication when a bounded polling window drops older messages', () => {
    const tracker = new RelayDeliveryTracker();
    tracker.consume(r());
    expect(tracker.consume(r([m('one')]))).toHaveLength(1);
    tracker.consume(r([m('two','coral-guide',3000)]));
    expect(tracker.consume(r([m('one')]))).toEqual([]);
  });
});

describe('per-author facial timeline', () => {
  const stores: RelayAvatarStore[] = [];
  const store = (random = () => 0.5) => { const s = new RelayAvatarStore(random); stores.push(s); s.setEnvironment(true); return s; };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { stores.splice(0).forEach(s=>s.stop()); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
  it('blinks at varied 4–8s intervals with actual open/half/closed frames', () => {
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(0.5);
    const s=store(random); s.observe('coral-guide');
    vi.advanceTimersByTime(3999); expect(s.getSnapshot('coral-guide').frame).toBe('open');
    vi.advanceTimersByTime(1); expect(s.getSnapshot('coral-guide').frame).toBe('half');
    vi.advanceTimersByTime(75); expect(s.getSnapshot('coral-guide').frame).toBe('closed');
    vi.advanceTimersByTime(175); expect(s.getSnapshot('coral-guide').frame).toBe('open');
    vi.advanceTimersByTime(7999); expect(s.getSnapshot('coral-guide').frame).toBe('open');
    vi.advanceTimersByTime(1); expect(s.getSnapshot('coral-guide').frame).toBe('half');
  });
  it('reacts exactly once for the author and synchronizes multiple observed copies', () => {
    const s=store(); const release1=s.observe('coral-guide'); s.observe('coral-guide'); s.observe('tide-scout');
    s.receive(m('fresh')); s.receive(m('fresh'));
    expect(s.getSnapshot('coral-guide')).toMatchObject({ frame: 'half', reactions: 1, lastMessageId: 'fresh' });
    expect(s.getSnapshot('tide-scout')).toMatchObject({ frame: 'open', reactions: 0 });
    release1(); vi.advanceTimersByTime(250);
    expect(s.getSnapshot('coral-guide').frame).toBe('happy');
    vi.advanceTimersByTime(600);
    expect(s.getSnapshot('coral-guide')).toMatchObject({ frame: 'open', phase: 'rest', reactions: 1 });
  });
  it('does not disturb the other author mid-blink', () => {
    const s=store(()=>0); s.observe('tide-scout'); vi.advanceTimersByTime(4075);
    expect(s.getSnapshot('tide-scout').frame).toBe('closed');
    s.observe('coral-guide'); s.receive(m('fresh'));
    expect(s.getSnapshot('tide-scout').frame).toBe('closed');
    expect(s.getSnapshot('coral-guide').frame).toBe('half');
  });
  it('serializes bursts without dropping a message delivered in the settling gap', () => {
    const s=store(); s.observe('coral-guide');
    s.receive(m('one')); s.receive(m('two'));
    vi.advanceTimersByTime(900); s.receive(m('three'));
    vi.advanceTimersByTime(2200);
    expect(s.getSnapshot('coral-guide')).toMatchObject({ frame: 'open', reactions: 3, lastMessageId: 'three' });
  });
  it('cancels timers when offscreen and does not replay offscreen delivery later', () => {
    const s=store(); const release=s.observe('coral-guide'); s.receive(m('one')); release();
    expect(vi.getTimerCount()).toBe(0);
    expect(s.getSnapshot('coral-guide').frame).toBe('open');
    s.receive(m('offscreen')); s.observe('coral-guide'); s.receive(m('offscreen'));
    expect(s.getSnapshot('coral-guide').reactions).toBe(1);
  });
  it('stays static with zero timers while disabled and restarts safely after cleanup', () => {
    const s=store(); s.observe('coral-guide'); s.receive(m('one'));
    s.setEnvironment(false); expect(vi.getTimerCount()).toBe(0);
    s.receive(m('reduced')); vi.advanceTimersByTime(20000);
    expect(s.getSnapshot('coral-guide')).toMatchObject({ frame: 'open', reactions: 1 });
    s.setEnvironment(true); expect(vi.getTimerCount()).toBe(1);
    s.stop(); expect(vi.getTimerCount()).toBe(0);
    s.setEnvironment(true); s.receive(m('reduced'));
    expect(s.getSnapshot('coral-guide').reactions).toBe(1);
  });
});
