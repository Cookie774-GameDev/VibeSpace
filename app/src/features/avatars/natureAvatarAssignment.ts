/** The published order is deliberate: each new identity takes the next portrait. */
export const NATURE_PROFILE_IDS = [
  '01-leaf-ghost', '02-acorn', '03-cloud', '04-mushroom', '05-starlight',
  '06-candle', '07-pebble', '08-origami-bird', '09-moth', '10-teacup',
  '11-crescent-moon', '12-fern', '13-snowdrop', '14-pinecone', '15-firefly',
  '16-seashell', '17-jellyfish', '18-coral', '19-snail', '20-amber',
  '21-ladybug', '22-dandelion', '23-fox-cub', '24-bunny', '25-otter',
  '26-hedgehog', '27-fawn',
] as const;

export type NatureAvatarAssignment = Readonly<{
  ordinal: number;
  profileId: (typeof NATURE_PROFILE_IDS)[number];
  monochrome: boolean;
}>;

const STORAGE_KEY = 'vibespace:nature-avatar-order:v1';

export function natureAvatarForOrdinal(ordinal: number): NatureAvatarAssignment {
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new RangeError('Avatar ordinal must be positive');
  return {
    ordinal,
    profileId: NATURE_PROFILE_IDS[(ordinal - 1) % NATURE_PROFILE_IDS.length],
    monochrome: ordinal > NATURE_PROFILE_IDS.length,
  };
}

function readOrder(storage?: Pick<Storage, 'getItem' | 'setItem'>): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed) || parsed.length > 10_000 ||
      parsed.some((item) => typeof item !== 'string' || !item.trim())) return [];
    return [...new Set(parsed as string[])];
  } catch { return []; }
}

/** An identity keeps its slot across chat, Relay and profile panels, including reloads. */
export class NatureAvatarAllocator {
  private order: string[];

  constructor(private storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.order = readOrder(storage);
  }

  assign(identity: string): NatureAvatarAssignment {
    const key = identity.trim() || 'assistant';
    // Read again so a second window's additions are visible before assigning.
    const persisted = readOrder(this.storage);
    if (persisted.length > this.order.length) this.order = persisted;
    let index = this.order.indexOf(key);
    if (index < 0) {
      index = this.order.push(key) - 1;
      try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.order)); } catch { /* Memory remains stable. */ }
    }
    return natureAvatarForOrdinal(index + 1);
  }
}

let sharedAllocator: NatureAvatarAllocator | undefined;

export function natureAvatarForIdentity(identity: string): NatureAvatarAssignment {
  if (!sharedAllocator) {
    let storage: Storage | undefined;
    try { storage = typeof window === 'undefined' ? undefined : window.localStorage; } catch { /* Restricted storage. */ }
    sharedAllocator = new NatureAvatarAllocator(storage);
  }
  return sharedAllocator.assign(identity);
}
