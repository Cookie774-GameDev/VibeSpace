import type { RelayRoomMessage, RelayRoomView } from './RelayGroupChat';

export type RelayAvatarProfile = 'coral-guide' | 'tide-scout';
export type RelayAvatarFrame = 'open' | 'half' | 'closed' | 'happy';
export type RelayAvatarSnapshot = Readonly<{
  frame: RelayAvatarFrame;
  phase: 'rest' | 'blink' | 'reaction';
  reactions: number;
  lastMessageId: string | null;
}>;
export const RELAY_AVATAR_FRAMES: readonly RelayAvatarFrame[] = ['open', 'half', 'closed', 'happy'];
export const RELAY_AVATAR_NAMES = { 'coral-guide': 'Coral Guide', 'tide-scout': 'Tide Scout' } as const;
const REST: RelayAvatarSnapshot = Object.freeze({ frame: 'open', phase: 'rest', reactions: 0, lastMessageId: null });

/** Never depend on list order, display name, presence, or a random assignment. */
export function avatarProfileForId(id: string): RelayAvatarProfile {
  if (id === 'coral-guide' || id === 'tide-scout') return id;
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 2 === 0 ? 'coral-guide' : 'tide-scout';
}

function deliveryKey(message: Pick<RelayRoomMessage, 'id' | 'participantId'>): string {
  return JSON.stringify([message.participantId, message.id]);
}

/** A connected snapshot is a baseline, not a stream of historical send events.
 * Older pages, repeats, enrichment and reconnect snapshots cannot replay faces.
 * Invalid/missing creation times are not evidence of a newly delivered message.
 */
export class RelayDeliveryTracker {
  private roomId: string | undefined;
  private ready = false;
  private watermark = -Infinity;
  private seen = new Set<string>();

  consume(room: RelayRoomView, active = true): RelayRoomMessage[] {
    const identity = room.roomId ?? room.scope;
    if (identity !== this.roomId) {
      this.roomId = identity;
      this.ready = false;
      this.watermark = -Infinity;
      this.seen.clear();
    }
    if (!active || room.connection !== 'connected') {
      this.ready = false;
      return [];
    }
    const agents = new Set(room.participants.filter((p) => p.kind === 'agent').map((p) => p.id));
    const previousWatermark = this.watermark;
    const fresh: RelayRoomMessage[] = [];
    for (const message of room.messages) {
      const key = deliveryKey(message);
      if (this.ready && !this.seen.has(key) && message.id && agents.has(message.participantId) &&
          Number.isFinite(message.at) && message.at >= previousWatermark) fresh.push(message);
      this.seen.add(key);
      if (Number.isFinite(message.at)) this.watermark = Math.max(this.watermark, message.at);
    }
    this.ready = true;
    return fresh.sort((a, b) => a.at - b.at);
  }
}

type Timer = ReturnType<typeof setTimeout>;
type AvatarRecord = {
  snapshot: RelayAvatarSnapshot;
  visible: Set<symbol>;
  listeners: Set<() => void>;
  timer: Timer | null;
  queue: Pick<RelayRoomMessage, 'id' | 'participantId'>[];
};

/** One timeline per author, shared by all that author's visible avatar instances.
 * Timers only exist while visible and enabled. A text send is never a voice loop.
 */
export class RelayAvatarStore {
  private records = new Map<string, AvatarRecord>();
  private played = new Set<string>();
  private enabled = false;

  constructor(private random: () => number = Math.random) {}

  private record(id: string): AvatarRecord {
    let record = this.records.get(id);
    if (!record) {
      record = { snapshot: REST, visible: new Set(), listeners: new Set(), timer: null, queue: [] };
      this.records.set(id, record);
    }
    return record;
  }

  getSnapshot = (id: string): RelayAvatarSnapshot => this.record(id).snapshot;

  subscribe(id: string, listener: () => void): () => void {
    const record = this.record(id);
    record.listeners.add(listener);
    return () => { record.listeners.delete(listener); };
  }

  private publish(record: AvatarRecord, patch: Partial<RelayAvatarSnapshot>): void {
    const next = { ...record.snapshot, ...patch };
    if (Object.keys(next).every((key) => next[key as keyof RelayAvatarSnapshot] === record.snapshot[key as keyof RelayAvatarSnapshot])) return;
    record.snapshot = next;
    for (const listener of record.listeners) listener();
  }

  private cancel(record: AvatarRecord): void {
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;
  }

  private pause(record: AvatarRecord): void {
    this.cancel(record);
    record.queue = [];
    this.publish(record, { frame: 'open', phase: 'rest' });
  }

  setEnvironment(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const record of this.records.values()) {
      if (!enabled) this.pause(record);
      else this.idle(record);
    }
  }

  observe(id: string): () => void {
    const record = this.record(id);
    const token = Symbol(id);
    record.visible.add(token);
    this.idle(record);
    return () => {
      record.visible.delete(token);
      if (record.visible.size === 0) this.pause(record);
    };
  }

  private later(record: AvatarRecord, delay: number, action: () => void): void {
    this.cancel(record);
    if (!this.enabled || !record.visible.size) return;
    record.timer = setTimeout(() => {
      record.timer = null;
      if (this.enabled && record.visible.size) action();
    }, delay);
  }

  private idle(record: AvatarRecord): void {
    if (!this.enabled || !record.visible.size || record.timer !== null || record.snapshot.phase !== 'rest') return;
    const delay = 4000 + Math.min(1, Math.max(0, this.random())) * 4000;
    this.later(record, delay, () => this.sequence(record));
  }

  private sequence(record: AvatarRecord, message?: Pick<RelayRoomMessage, 'id' | 'participantId'>): void {
    this.cancel(record);
    this.publish(record, {
      frame: 'half', phase: message ? 'reaction' : 'blink',
      ...(message ? { reactions: record.snapshot.reactions + 1, lastMessageId: message.id } : {}),
    });
    this.later(record, 75, () => {
      this.publish(record, { frame: 'closed' });
      this.later(record, 100, () => {
        this.publish(record, { frame: 'half' });
        this.later(record, 75, () => {
          if (message) {
            this.publish(record, { frame: 'happy' });
            this.later(record, 600, () => this.settle(record));
          } else this.settle(record);
        });
      });
    });
  }

  private settle(record: AvatarRecord): void {
    const next = record.queue.shift();
    // Keep the reaction phase during the settling gap: another delivery must
    // queue behind the already-scheduled message, not cancel its timer.
    this.publish(record, { frame: 'open', phase: next ? 'reaction' : 'rest' });
    if (next) this.later(record, 120, () => this.sequence(record, next));
    else this.idle(record);
  }

  receive(message: Pick<RelayRoomMessage, 'id' | 'participantId'>): void {
    const key = deliveryKey(message);
    if (this.played.has(key)) return;
    this.played.add(key);
    const record = this.record(message.participantId);
    if (!this.enabled || !record.visible.size) return;
    if (record.snapshot.phase === 'reaction' || record.queue.length) record.queue.push(message);
    else this.sequence(record, message);
  }

  stop(): void {
    this.enabled = false;
    for (const record of this.records.values()) this.pause(record);
  }
}
