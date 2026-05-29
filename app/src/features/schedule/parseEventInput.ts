/**
 * Lightweight, dependency-free natural-language event parser.
 *
 * Recognises forms like:
 *   - "lunch with Sam at 1pm"
 *   - "team standup tomorrow 9:30"
 *   - "deploy review Friday at 4"
 *   - "vacation Aug 20"
 *   - "dentist 2025-06-12 14:00"
 *
 * Returns a partial event spec callers can fold into eventRepo.create.
 * Anything we can't parse (e.g. complex recurrences) just falls through
 * with default start/end values one hour from now.
 *
 * V2 scope: keep this tight. Schedule plan-B2 §4.3 has an LLM fallback for
 * harder phrases — that lands in E2/E3. This regex pass handles the 90%
 * case offline so the user never has to wait for a network round-trip.
 */

export interface ParsedEvent {
  title: string;
  start_at: number;
  end_at: number;
  all_day: boolean;
}

const WEEKDAY_TO_NUM: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const MONTH_TO_NUM: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const ONE_HOUR = 60 * 60 * 1000;

/** Strip a leading temporal phrase from the user's title and return both. */
function stripPhrase(input: string, phrase: string): string {
  const trimmed = input.replace(new RegExp(`\\b${phrase}\\b`, 'i'), '').replace(/\s{2,}/g, ' ').trim();
  return trimmed || input.trim();
}

/** Parse "3pm" / "3:30pm" / "15:30" / "15" → minutes-from-midnight. */
function parseTime(s: string): { hours: number; minutes: number } | null {
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = (m[3] ?? '').toLowerCase();
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/** Apply HH:MM to a date (mutating). */
function setClock(d: Date, hours: number, minutes: number): void {
  d.setHours(hours, minutes, 0, 0);
}

/**
 * Parse a free-form event description. Always returns a plausible result so
 * callers can submit even bad inputs (the user can edit afterwards).
 */
export function parseEventInput(input: string, ref: Date = new Date()): ParsedEvent {
  const original = input.trim();
  if (!original) {
    const start = new Date(ref);
    setClock(start, start.getHours() + 1, 0);
    return {
      title: 'Untitled event',
      start_at: start.getTime(),
      end_at: start.getTime() + ONE_HOUR,
      all_day: false,
    };
  }

  let working = original;
  let date = new Date(ref);
  date.setSeconds(0, 0);
  let allDay = true; // becomes false if we find a time component

  // ---- Date phrases ----
  const todayMatch = /\btoday\b/i.exec(working);
  const tomorrowMatch = /\btomorrow\b/i.exec(working);
  const weekdayMatch = /\b(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b/i.exec(working);
  const isoDateMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(working);
  const usDateMatch = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(working);
  const monthDayMatch = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i.exec(working);

  if (todayMatch) {
    working = stripPhrase(working, 'today');
  } else if (tomorrowMatch) {
    date.setDate(date.getDate() + 1);
    working = stripPhrase(working, 'tomorrow');
  } else if (isoDateMatch) {
    const [, y, mo, d] = isoDateMatch;
    date = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
    working = working.replace(isoDateMatch[0], '').trim();
  } else if (usDateMatch) {
    const [, mo, d, y] = usDateMatch;
    const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : ref.getFullYear();
    date = new Date(year, Number(mo) - 1, Number(d), 0, 0, 0, 0);
    working = working.replace(usDateMatch[0], '').trim();
  } else if (monthDayMatch) {
    const monthIdx = MONTH_TO_NUM[monthDayMatch[1].toLowerCase()];
    const day = Number(monthDayMatch[2]);
    if (monthIdx !== undefined && !Number.isNaN(day)) {
      date = new Date(ref.getFullYear(), monthIdx, day, 0, 0, 0, 0);
      // If that already passed this year, roll to next year.
      if (date.getTime() < ref.getTime() - 24 * 60 * 60 * 1000) {
        date.setFullYear(date.getFullYear() + 1);
      }
      working = working.replace(monthDayMatch[0], '').trim();
    }
  } else if (weekdayMatch) {
    const target = WEEKDAY_TO_NUM[weekdayMatch[1].toLowerCase()];
    if (target !== undefined) {
      const today = date.getDay();
      let delta = target - today;
      if (delta <= 0) delta += 7;
      date.setDate(date.getDate() + delta);
      working = working.replace(weekdayMatch[0], '').trim();
    }
  }

  // ---- Time phrases ----
  const atMatch = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(working);
  const looseTimeMatch = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.exec(working);
  const time24Match = /\b(\d{2}):(\d{2})\b/.exec(working);

  if (atMatch) {
    const t = parseTime(atMatch[1]);
    if (t) {
      setClock(date, t.hours, t.minutes);
      allDay = false;
      working = working.replace(atMatch[0], '').trim();
    }
  } else if (looseTimeMatch) {
    const t = parseTime(looseTimeMatch[1]);
    if (t) {
      setClock(date, t.hours, t.minutes);
      allDay = false;
      working = working.replace(looseTimeMatch[0], '').trim();
    }
  } else if (time24Match) {
    const hours = Number(time24Match[1]);
    const minutes = Number(time24Match[2]);
    if (hours <= 23 && minutes <= 59) {
      setClock(date, hours, minutes);
      allDay = false;
      working = working.replace(time24Match[0], '').trim();
    }
  }

  // Default time if nothing parsed: next round hour from `ref`.
  if (allDay && (todayMatch || tomorrowMatch || weekdayMatch || isoDateMatch || usDateMatch || monthDayMatch)) {
    // Date-only result — keep all-day.
  } else if (allDay) {
    // Couldn't parse anything date/time-ish; assume next hour from now.
    date = new Date(ref);
    date.setHours(date.getHours() + 1, 0, 0, 0);
    allDay = false;
  }

  // ---- Title ----
  const titleClean = working
    .replace(/^(at|on|the)\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const title = titleClean || original;

  const start = date.getTime();
  const end = allDay ? start + 24 * 60 * 60 * 1000 - 1 : start + ONE_HOUR;
  return {
    title,
    start_at: start,
    end_at: end,
    all_day: allDay,
  };
}
