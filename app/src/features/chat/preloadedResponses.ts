/**
 * Preloaded openers for freshly created chats.
 *
 * Every newly created chat is seeded with one very short assistant response,
 * cycling through the list below so each new chat opens with the next line
 * (wrapping after the last entry). The cursor persists in localStorage so the
 * cycle survives reloads and restarts. Seeding is decorative and best-effort:
 * it must never block or fail chat creation.
 */
import { messageRepo } from '@/lib/db';
import type { Chat } from '@/types';
import type { ChatId } from '@/types/common';

export const PRELOADED_RESPONSES: readonly string[] = [
  'Hey.',
  "I'm listening.",
  'Ready when you are.',
  'What are we building?',
  'Systems green.',
  'Go ahead.',
  "I'm here.",
  'Say the word.',
  'Standing by.',
  'Fresh thread, clear mind.',
  'At your service.',
  'What first?',
  'Cores warm.',
  'Thinking cap on.',
  'Morning, boss.',
  'Back online.',
  'All systems nominal.',
  "Let's make something.",
  'Clock is ticking.',
  'I have ideas.',
  'Ask me anything.',
  'New page.',
  'Where do we start?',
  'I was just thinking about you.',
  'Ready to roll.',
  'Zero inbox. Beautiful.',
  'Coffee first?',
  'Diagnostics done.',
  'On it - well, almost.',
  'Hit me.',
  'Calm before the build.',
  'Everything checks out.',
  'Your move.',
  'Ideas loaded.',
  'What trouble are we making?',
  'Powered up.',
  'Quiet in here.',
  'Give me something hard.',
  'Blank canvas.',
  'Booting curiosity.',
  'I saved you a seat.',
  'Lead the way.',
  'Fasten your seatbelt.',
  'Ship it? Say when.',
  'New thread, who dis?',
  'Sensors sweep clear.',
  "Let's get into it.",
  'Short and useful today.',
  'Warming up.',
  'You have my full attention.',
  'One good idea, coming up.',
  "Let's keep it simple.",
  'I drafted three plans already.',
  'The hard part first.',
  'Break something? Fix something?',
  'Momentum detected.',
  'Ask a better question.',
  'Terminal warm. Coffee cold.',
  'Consider me inspired.',
  'Feeling productive today.',
  'State saved. Mind clear.',
  "Let's go.",
  'I brought snacks.',
  'The queue is empty. Bliss.',
  'Nothing broken. Yet.',
  'Bring the weird ideas.',
  'First draft energy.',
  'Right on time.',
  'Locked in.',
  'Slightly over-caffeinated.',
  'Big things, small steps.',
  'The lab is open.',
  'Curiosity at maximum.',
  'Say less.',
  'Running the numbers.',
  'Charging... just kidding. Ready.',
  'Fresh build, no bugs. Yet.',
  'Today we ship.',
  'I like this plan already.',
  'A clean slate.',
  'Quiet focus mode.',
  "Let's sketch it out.",
  'Prompt me, I dare you.',
  'Up and running.',
  'No context needed - I remember.',
  'Half a thought? I will take it.',
  'Prime the engines.',
  "Let's be efficient.",
  'Start with the goal.',
  "I'm three steps ahead.",
  'Draw the map. We will walk it.',
  'Low drama, high output.',
  'Green lights all the way.',
  'Something great today.',
  'Just say when.',
  'Ready for the twist.',
  'Onward.',
  'Talk to me.',
  'Make it count.',
  'We move.',
];

const STORAGE_KEY = 'vibespace:preloaded-response:v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function readCursor(storage: StorageLike | undefined): number {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { cursor?: unknown };
    const cursor = Number(parsed?.cursor);
    return Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0;
  } catch {
    return 0;
  }
}

/**
 * Returns the next preloaded response in the cycle and advances the persisted
 * cursor. Storage failures are swallowed; the read cursor still advances the
 * in-cycle pick so a broken store cannot pin one line forever.
 */
export function nextPreloadedResponse(
  storage: StorageLike | undefined = globalThis.localStorage,
): string {
  const total = PRELOADED_RESPONSES.length;
  if (total === 0) return '';
  const cursor = readCursor(storage);
  const text = PRELOADED_RESPONSES[cursor % total];
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ cursor: cursor + 1 }));
  } catch {
    // Ignore - a failed persist must not break the pick.
  }
  return text;
}

/**
 * Seeds a freshly created chat with the next preloaded response. Fire-and-forget
 * by design: any failure (storage, DB) is swallowed so chat creation never
 * surfaces an error from this feature.
 */
export async function seedPreloadedChatResponse(chat: { id: ChatId }): Promise<void> {
  try {
    const text = nextPreloadedResponse();
    if (!text) return;
    await messageRepo.create({
      chat_id: chat.id,
      role: 'assistant',
      parts: [{ kind: 'text', text }],
    });
  } catch {
    // Decorative only - never let a greeting break chat creation.
  }
}
